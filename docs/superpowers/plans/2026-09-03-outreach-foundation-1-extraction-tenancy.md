# Outreach Foundation — Plan 1: Package Extraction + Tenancy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the CTI's shared substrate (database, phone, auth + crypto, firewall) into `packages/*` as a pure refactor, then make `organizations` a real tenant boundary — with the reps' softphone behaving identically throughout.

**Architecture:** Packages are built libraries: each has `src/`, compiles with `tsc` to `dist/`, and is consumed via `package.json` `exports` (`types` → `dist/index.d.ts`, `default` → `dist/index.js`). `cti-api` depends on them as workspace packages (`"@cti/db": "*"`) and keeps its own conventions (Fastify, zod config, vitest fake-DB mocks). The firewall's one outward dependency (Salesforce record lookup) becomes an injected port. Tenancy lands as one additive migration plus a `createTenant` helper, a hardened session module, and two small route changes.

**Tech Stack:** TypeScript 5.6 strict, Node ≥ 20.10 (dev machine runs 22), npm 10 workspaces, Drizzle ORM 0.36 + `pg`, vitest 2.1, Railway (Dockerfile build), Postgres.

**Spec:** `docs/superpowers/specs/2026-09-03-outreach-foundation-design.md` §3.1, §3.2, §4, §12, §13 steps 1–2. Program context: `docs/superpowers/specs/2026-09-03-ai-outreach-program-design.md`.

**Baseline (verified 2026-09-03 on commit 411af3a):** `npm -w services/cti-api run typecheck` clean; `npm -w services/cti-api run test` → 62 files, 777 tests pass; `npm -w apps/cti-web run test` → 17 files, 124 tests pass.

## Global Constraints

- Repo: `/Users/cdrshepard/spam-res-cti`. Branch: `feat/outreach-foundation`. Commit after every task. Do NOT push.
- Every task ends with: `npm run build:packages` succeeds, `npm -w services/cti-api run typecheck` clean, `npm -w services/cti-api run test` green with the file/test counts stated in the task, and every package's own tests green. Tasks 1–7 are **pure refactors**: no runtime behavior change in `cti-api`.
- TypeScript strict everywhere, `noUncheckedIndexedAccess: true`, `moduleResolution: "Bundler"`, ESM (`"type": "module"`), **`.js` extensions on relative import specifiers** (existing `cti-api` convention; packages follow it).
- Package names: `@cti/phone`, `@cti/db`, `@cti/auth`, `@cti/firewall`. Workspace dependency declarations use `"*"`.
- Dependency versions are copied from `services/cti-api/package.json`: `drizzle-orm ^0.36.4`, `pg ^8.13.1`, `dotenv ^16.4.5`, `google-libphonenumber ^3.2.40`, `@types/google-libphonenumber ^7.4.30`, `@types/pg ^8.11.10`, `@types/node ^20.17.0`, `drizzle-kit ^0.28.1`, `tsx ^4.19.2`, `typescript ^5.6.3`, `vitest ^2.1.5`.
- Migrations: plain SQL, numbered (`0036_…`), idempotent (`if not exists`, `do $$ … $$` guards for constraints), one transaction each (the runner wraps them).
- Compliance code fails closed. No secrets in logs. No new files over 800 lines; new functions under 50 lines.
- Commit message format: `<type>(<scope>): <description>` with types `feat|fix|refactor|docs|test|chore`. No `Co-Authored-By` trailer (attribution is disabled in this user's global settings).
- The original firewall file is referenced by commit: `git show 411af3a:services/cti-api/src/firewall/index.ts`. Line numbers below refer to that revision.
- macOS `sed -i` needs `-i ''`; the codemods below use `perl -pi -e` for portability. In a perl double-quoted replacement, `@` must be written `\@`.
- When a vitest partial mock of a `@cti/*` package fails to apply (symptom: the real `getDb()` runs and throws `DATABASE_URL is not set`), add `services/cti-api/vitest.config.ts` with `export default defineConfig({ test: { server: { deps: { inline: [/^@cti\//] } } } })` (import `defineConfig` from `vitest/config`). This is a documented fallback, not an expected step.

---

## File Structure (end state of this plan)

```
packages/
  phone/     package.json, tsconfig.json, src/index.ts (was services/cti-api/src/phone.ts), src/index.test.ts
  db/        package.json, tsconfig.json, drizzle.config.ts, migrations/ (moved), src/index.ts, src/schema.ts,
             src/migrate.ts (CLI), src/migrate-runner.ts (pure, advisory-locked), src/migrate-runner.test.ts,
             src/date-parser.test.ts
  auth/      package.json, tsconfig.json, src/index.ts, src/crypto.ts, src/crypto.test.ts, src/session.ts,
             src/session.test.ts, src/tenancy.ts, src/tenancy.test.ts
  firewall/  package.json, tsconfig.json, src/index.ts, src/types.ts, src/errors.ts, src/reasons.ts,
             src/aggregate.ts, src/attempts.ts, src/recipient.ts, src/velocity.ts, src/calling-hours.ts,
             src/calling-window.ts, src/evaluate.ts, src/evaluate.test.ts, src/tz.ts, src/state-calling-rules.ts,
             src/warmup.ts, src/rotation.ts, src/reputation/signals.ts, src/reputation/query.ts, + moved tests
services/cti-api/src/
  firewall/recipient-address.ts         adapter: Salesforce fetchRecordAddress → firewall port
  dialer/calling-hours-drift.test.ts    interlock test (moved from firewall/; imports both sides)
  tenancy/user-queries.ts (+ test)      org-scoped, human-only user predicates used by auth + admin routes
  (db/, phone.ts, crypto.ts, auth/, rotation.ts, reputation/{query,signals}.ts, firewall/index.ts: removed)
docs/runbooks/tenancy-migration.md
```

---

### Task 1: `packages/phone` + workspace scaffolding

**Files:**
- Create: `packages/phone/package.json`, `packages/phone/tsconfig.json`
- Move: `services/cti-api/src/phone.ts` → `packages/phone/src/index.ts`; `services/cti-api/src/phone.test.ts` → `packages/phone/src/index.test.ts`
- Modify: `package.json` (root), `services/cti-api/package.json`, and the 10 importers of `phone.js` in `services/cti-api/src` (`firewall/index.ts`, `mobile/directory-build.ts`, `routes/admin.ts`, `routes/auth.ts`, `routes/calls.ts`, `routes/firewall.ts`, `routes/inbound.ts`, `routes/integrations.ts`, `salesforce/record-phone.ts`, `salesforce/sync.ts`). `dialer/create-session.ts` and `routes/dialer.ts` import `salesforce/record-phone.js`, a different module — do not touch them.

**Interfaces:**
- Produces: `@cti/phone` exporting `normalize(raw: string, defaultRegion = 'US'): NormalizeResult`, `toE164(raw: string, defaultRegion = 'US'): string | null`, `NormalizedPhone`, `NormalizeResult` — unchanged from `phone.ts`.
- Produces: root scripts `build:packages`, and `typecheck`/`test`/`build:api`/`dev:api` that build packages first.

- [ ] **Step 1: Create the package manifest and tsconfig**

`packages/phone/package.json`:
```json
{
  "name": "@cti/phone",
  "version": "0.1.0",
  "private": true,
  "description": "Phone number normalization shared by every CTI service",
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
    "google-libphonenumber": "^3.2.40"
  },
  "devDependencies": {
    "@types/google-libphonenumber": "^7.4.30",
    "@types/node": "^20.17.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.5"
  }
}
```

`packages/phone/tsconfig.json` (this exact file is reused by every package in this plan):
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "sourceMap": true,
    "verbatimModuleSyntax": false
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 2: Move the source and its test**

```bash
cd /Users/cdrshepard/spam-res-cti
mkdir -p packages/phone/src
git mv services/cti-api/src/phone.ts packages/phone/src/index.ts
git mv services/cti-api/src/phone.test.ts packages/phone/src/index.test.ts
perl -pi -e "s#'\./phone\.js'#'./index.js'#g" packages/phone/src/index.test.ts
grep -n "from '" packages/phone/src/index.test.ts
```
Expected: the test imports `from './index.js'` and `from 'vitest'` only.

- [ ] **Step 3: Wire the workspace**

Root `package.json` — replace the `workspaces` array and the `scripts` block with:
```json
  "workspaces": [
    "packages/*",
    "services/*",
    "apps/*"
  ],
  "scripts": {
    "build:packages": "npm -w packages/phone run build",
    "dev:api": "npm run build:packages && npm --workspace services/cti-api run dev",
    "dev:web": "npm --workspace apps/cti-web run dev",
    "dev:desktop": "npm --workspace apps/cti-desktop run dev",
    "build:api": "npm run build:packages && npm --workspace services/cti-api run build",
    "build:web": "npm --workspace apps/cti-web run build",
    "build:desktop": "npm --workspace apps/cti-desktop run build",
    "migrate": "npm --workspace services/cti-api run migrate",
    "migrate:make": "npm --workspace services/cti-api run migrate:make",
    "typecheck": "npm run build:packages && npm --workspaces --if-present run typecheck",
    "lint": "npm --workspaces --if-present run lint",
    "test": "npm run build:packages && npm --workspaces --if-present run test"
  },
```

`services/cti-api/package.json` — add to `dependencies` (keep the rest):
```json
    "@cti/phone": "*",
```

```bash
cd /Users/cdrshepard/spam-res-cti && npm install && ls -la node_modules/@cti/ && npm run build:packages && ls packages/phone/dist/
```
Expected: `node_modules/@cti/phone -> ../../packages/phone` symlink; `dist/index.js`, `dist/index.d.ts`, `dist/index.test.js` exist.

- [ ] **Step 4: Rewrite the consumers**

```bash
cd /Users/cdrshepard/spam-res-cti/services/cti-api
perl -pi -e "s#'(\.\./)+phone\.js'#'\@cti/phone'#g" $(grep -rlE "'(\.\./)+phone\.js'" src)
grep -rnE "'(\.\./)+phone\.js'" src || echo "OK: no relative phone imports remain"
grep -rl "@cti/phone" src | wc -l
```
Expected: `OK: …` and `10`. (`record-phone.js` imports are a different module and must remain.)

- [ ] **Step 5: Verify**

```bash
cd /Users/cdrshepard/spam-res-cti
npm -w services/cti-api run typecheck && npm -w packages/phone run test && npm -w services/cti-api run test 2>&1 | tail -6
```
Expected: typecheck clean; phone: 1 file, 6 tests pass; cti-api: **61 files, 771 tests** pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti
git add package.json package-lock.json packages/phone services/cti-api
git commit -m "refactor(packages): extract @cti/phone and add package build to the workspace

Pure move of phone.ts + its test into packages/phone, consumed by cti-api as a
built workspace package (exports -> dist). Root scripts build packages before
typecheck/test/build/dev. No behavior change."
```

---

### Task 2: `packages/db` (schema, connection, migrations, deploy wiring)

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/drizzle.config.ts`
- Move: `services/cti-api/src/db/schema.ts` → `packages/db/src/schema.ts`; `services/cti-api/src/db/index.ts` → `packages/db/src/index.ts`; `services/cti-api/src/db/migrate.ts` → `packages/db/src/migrate.ts`; `services/cti-api/src/db/dateParser.test.ts` → `packages/db/src/date-parser.test.ts`; `services/cti-api/migrations/` → `packages/db/migrations/`
- Delete: `services/cti-api/drizzle.config.ts`
- Modify: root `package.json`, `services/cti-api/package.json`, `railway.json`, `Dockerfile`, `.gitignore`, and every `db/index.js` / `db/schema.js` importer in `services/cti-api/src` (34 source files + 12 test files)

**Interfaces:**
- Produces: `@cti/db` exporting `getPool(): pg.Pool`, `getDb(): Db`, `type Db = NodePgDatabase<typeof schema>`, `schema` (namespace of every table), and the type helpers `User, Organization, OutboundNumber, CampaignConfig, SalesforceConnection, DialerHandoff, FollowupRolloverJob, CallerDirectoryVersion, CallerDirectoryEntry, MobileDevice, MobilePairCode, Call, NewCall, PreCallAudit`.
- Connection string comes from `process.env.DATABASE_URL` (each service still validates it at boot in its own `config.ts`).

- [ ] **Step 1: Package manifest, tsconfig, drizzle config**

`packages/db/package.json`:
```json
{
  "name": "@cti/db",
  "version": "0.1.0",
  "private": true,
  "description": "Postgres connection, Drizzle schema, and SQL migrations shared by every CTI service",
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
    "test": "vitest run",
    "migrate": "tsx src/migrate.ts",
    "migrate:make": "drizzle-kit generate"
  },
  "dependencies": {
    "dotenv": "^16.4.5",
    "drizzle-orm": "^0.36.4",
    "pg": "^8.13.1"
  },
  "devDependencies": {
    "@types/node": "^20.17.0",
    "@types/pg": "^8.11.10",
    "drizzle-kit": "^0.28.1",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.5"
  }
}
```
`packages/db/tsconfig.json`: identical to `packages/phone/tsconfig.json`.

`packages/db/drizzle.config.ts`:
```ts
import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/cti_dev',
  },
  strict: true,
});
```

- [ ] **Step 2: Move files**

```bash
cd /Users/cdrshepard/spam-res-cti
mkdir -p packages/db/src
git mv services/cti-api/src/db/schema.ts packages/db/src/schema.ts
git mv services/cti-api/src/db/index.ts packages/db/src/index.ts
git mv services/cti-api/src/db/migrate.ts packages/db/src/migrate.ts
git mv services/cti-api/src/db/dateParser.test.ts packages/db/src/date-parser.test.ts
git mv services/cti-api/migrations packages/db/migrations
git rm -q services/cti-api/drizzle.config.ts
ls packages/db/migrations | wc -l
```
Expected: `35`.

- [ ] **Step 3: Rewrite `packages/db/src/index.ts`** (replace the whole file; the type-parser comment is preserved verbatim from the original because it documents a production incident)

```ts
import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

const { Pool } = pg;

// CRITICAL: node-postgres parses Postgres `date` (OID 1082) columns into JS
// `Date` objects at local midnight by default. Our only date column,
// `outbound_numbers.dials_today_date`, is modeled as text/`YYYY-MM-DD` in the
// Drizzle schema and compared with string equality against
// `new Date().toISOString().slice(0,10)` in the warmup-cap gate
// (firewall), the rotation pool, and the reputation dashboard. A
// `Date === string` comparison is ALWAYS false — which silently disabled the
// per-DID daily warmup cap, the single most important defense against
// fresh-DID "Spam Likely" labeling. Force the driver to return `date` values
// as the raw `YYYY-MM-DD` string so the model and the runtime representation
// agree everywhere.
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);

/** The Drizzle handle every service and package shares. */
export type Db = NodePgDatabase<typeof schema>;

let pool: pg.Pool | undefined;
let dbInstance: Db | undefined;

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return url;
}

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({ connectionString: connectionString(), max: 10 });
    // node-postgres Pool is an EventEmitter. A managed Postgres (Railway)
    // routinely closes idle connections, which emits an 'error' on the idle
    // client. Node throws on an unhandled EventEmitter 'error' — crashing the
    // whole API and dropping every in-flight call over ordinary idle churn.
    // Log and swallow; the pool transparently opens a fresh connection on the
    // next query.
    pool.on('error', (err) => {
      console.error('[db] idle client error (recovered):', err instanceof Error ? err.message : err);
    });
  }
  return pool;
}

export function getDb(): Db {
  if (!dbInstance) {
    dbInstance = drizzle(getPool(), { schema });
  }
  return dbInstance;
}

export { schema };
export type {
  Call,
  CallerDirectoryEntry,
  CallerDirectoryVersion,
  CampaignConfig,
  DialerHandoff,
  FollowupRolloverJob,
  MobileDevice,
  MobilePairCode,
  NewCall,
  Organization,
  OutboundNumber,
  PreCallAudit,
  SalesforceConnection,
  User,
} from './schema.js';
```

- [ ] **Step 4: Point `migrate.ts` at its new home and keep local dev working**

In `packages/db/src/migrate.ts` replace the header (from the first `import` through the `MIGRATIONS_DIR` constant) with:
```ts
import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { getPool } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Env resolution: the caller's cwd `.env` first (how CI and Railway supply it),
// then the API service's `.env` so `npm run migrate` from the repo root keeps
// working for local dev exactly as it did before the move to packages/db.
// `getPool()` reads DATABASE_URL lazily, so loading env after the imports is safe.
dotenv.config();
if (!process.env.DATABASE_URL) {
  const apiEnv = resolve(__dirname, '../../../services/cti-api/.env');
  if (existsSync(apiEnv)) dotenv.config({ path: apiEnv });
}

// `src/migrate.ts` and `dist/migrate.js` sit at the same depth, so this resolves
// to packages/db/migrations from either.
const MIGRATIONS_DIR = resolve(__dirname, '../migrations');
```
Leave `ensureTable`, `listApplied`, and `main` unchanged for now (Task 3 restructures them).

Update the test's import: in `packages/db/src/date-parser.test.ts` the line `import './index.js';` is already correct — confirm with `grep -n "index.js" packages/db/src/date-parser.test.ts`.

- [ ] **Step 5: Root and service manifests, deploy config**

Root `package.json` scripts — change these three lines:
```json
    "build:packages": "npm -w packages/phone run build && npm -w packages/db run build",
    "migrate": "npm --workspace packages/db run migrate",
    "migrate:make": "npm --workspace packages/db run migrate:make",
```

`services/cti-api/package.json`: remove the `"migrate"` and `"migrate:make"` scripts and the `"drizzle-kit"` devDependency; add `"@cti/db": "*"` to `dependencies`.

`railway.json`: change `"preDeployCommand"` to `"npm --workspace packages/db run migrate"`.

`.gitignore`: replace `services/cti-api/drizzle/meta/` with `packages/db/drizzle/meta/`.

`Dockerfile`: replace the manifest COPY block with
```dockerfile
COPY package.json package-lock.json ./
COPY packages/phone/package.json packages/phone/package.json
COPY packages/db/package.json packages/db/package.json
COPY services/cti-api/package.json services/cti-api/package.json
COPY apps/cti-web/package.json apps/cti-web/package.json
COPY apps/cti-desktop/package.json apps/cti-desktop/package.json
RUN npm ci --include=dev
```
and the build line with `RUN npm run build:web && npm run build:api` (root `build:api` now builds packages first).

```bash
cd /Users/cdrshepard/spam-res-cti && npm install && npm run build:packages && ls packages/db/dist/ | head
```
Expected: `index.js`, `index.d.ts`, `schema.js`, `schema.d.ts`, `migrate.js` present.

- [ ] **Step 6: Rewrite consumers (sources, tests, and mocks in one pass)**

```bash
cd /Users/cdrshepard/spam-res-cti/services/cti-api
perl -pi -e "s#'(\.\./)+db/index\.js'#'\@cti/db'#g; s#'\./db/index\.js'#'\@cti/db'#g; s#'(\.\./)+db/schema\.js'#'\@cti/db'#g" $(grep -rlE "db/(index|schema)\.js'" src)
grep -rnE "db/(index|schema)\.js'" src || echo "OK: no relative db imports remain"
grep -rn "vi.mock('@cti/db'" src | wc -l
```
Expected: `OK: …` and `5` (admin-team, calls-disposition, dialer-handoffs, inbound, mobile route tests).

- [ ] **Step 7: Verify**

```bash
cd /Users/cdrshepard/spam-res-cti
npm -w services/cti-api run typecheck && npm -w packages/db run test && npm -w services/cti-api run test 2>&1 | tail -6
```
Expected: typecheck clean; db: 1 file, 2 tests; cti-api: **60 files, 769 tests**. If a route test fails with `DATABASE_URL is not set`, apply the vitest inline fallback from Global Constraints and re-run.

Optional local check (only if `services/cti-api/.env` points at a dev database): `npm run migrate` → `[migrate] done (0 new of 35 total)`.

- [ ] **Step 8: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti
git add -A package.json package-lock.json packages/db services/cti-api railway.json Dockerfile .gitignore
git commit -m "refactor(packages): extract @cti/db — schema, connection, migrations

Pure move of the Drizzle schema, pg pool, migration runner, and the migrations
directory into packages/db. Connection string now read from DATABASE_URL at call
time (services still validate it at boot). Railway pre-deploy and Docker build
point at the package. No behavior change."
```

---

### Task 3: Advisory-locked migration runner (TDD)

**Files:**
- Create: `packages/db/src/migrate-runner.ts`, `packages/db/src/migrate-runner.test.ts`
- Modify: `packages/db/src/migrate.ts`

**Interfaces:**
- Produces: `runMigrations(client: MigrationClient, files: ReadonlyArray<MigrationFile>, log?: MigrationLogger): Promise<number>`; `MIGRATION_LOCK_KEY = 727001`; types `MigrationFile { name: string; sql: string }`, `MigrationClient { query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> }`, `MigrationLogger { info(msg: string): void; error(msg: string): void }`.
- Why: two Railway services now deploy from one push and both run `preDeployCommand`; the lock serializes them so the second finds nothing to apply instead of racing on `cti_schema_migrations`.

- [ ] **Step 1: Write the failing tests**

`packages/db/src/migrate-runner.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { MIGRATION_LOCK_KEY, runMigrations, type MigrationClient } from './migrate-runner.js';

interface Recorded { text: string; values?: readonly unknown[] }

function fakeClient(opts: { applied?: string[]; failOnSql?: string } = {}) {
  const log: Recorded[] = [];
  const client: MigrationClient = {
    async query(text, values) {
      log.push({ text, values });
      if (opts.failOnSql && text === opts.failOnSql) throw new Error('boom');
      if (text.startsWith('select filename')) {
        return { rows: (opts.applied ?? []).map((filename) => ({ filename })) };
      }
      return { rows: [] };
    },
  };
  return { client, log };
}

const quiet = { info: () => {}, error: () => {} };
const files = [
  { name: '0002_b.sql', sql: 'create table b()' },
  { name: '0001_a.sql', sql: 'create table a()' },
];

describe('runMigrations', () => {
  it('takes the advisory lock before anything else and releases it last', async () => {
    const { client, log } = fakeClient();
    await runMigrations(client, files, quiet);
    expect(log[0]).toEqual({ text: 'select pg_advisory_lock($1)', values: [MIGRATION_LOCK_KEY] });
    expect(log[log.length - 1]).toEqual({ text: 'select pg_advisory_unlock($1)', values: [MIGRATION_LOCK_KEY] });
  });

  it('applies unapplied files in lexical order, each in its own transaction, and records them', async () => {
    const { client, log } = fakeClient({ applied: ['0001_a.sql'] });
    const n = await runMigrations(client, files, quiet);
    expect(n).toBe(1);
    const texts = log.map((r) => r.text);
    const begin = texts.indexOf('begin');
    expect(texts.slice(begin, begin + 4)).toEqual([
      'begin',
      'create table b()',
      'insert into cti_schema_migrations(filename) values ($1)',
      'commit',
    ]);
    expect(log[begin + 2]!.values).toEqual(['0002_b.sql']);
    expect(texts).not.toContain('create table a()');
  });

  it('returns 0 and runs no transaction when everything is applied', async () => {
    const { client, log } = fakeClient({ applied: ['0001_a.sql', '0002_b.sql'] });
    expect(await runMigrations(client, files, quiet)).toBe(0);
    expect(log.map((r) => r.text)).not.toContain('begin');
  });

  it('rolls back a failing file, rethrows, and still releases the lock', async () => {
    const { client, log } = fakeClient({ failOnSql: 'create table a()' });
    await expect(runMigrations(client, files, quiet)).rejects.toThrow('boom');
    const texts = log.map((r) => r.text);
    expect(texts).toContain('rollback');
    expect(texts).not.toContain('commit');
    expect(log[log.length - 1]!.text).toBe('select pg_advisory_unlock($1)');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/cdrshepard/spam-res-cti && npm -w packages/db run test 2>&1 | tail -8
```
Expected: FAIL — `Cannot find module './migrate-runner.js'` (or equivalent resolution error).

- [ ] **Step 3: Implement the runner**

`packages/db/src/migrate-runner.ts`:
```ts
/**
 * Pure migration runner: applies *.sql files in lexical order, tracking applied
 * filenames in cti_schema_migrations, under a Postgres session-level advisory
 * lock so two services deploying from one push cannot race each other.
 */
export interface MigrationFile {
  name: string;
  sql: string;
}

export interface MigrationClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface MigrationLogger {
  info(msg: string): void;
  error(msg: string): void;
}

/** Arbitrary bigint shared by every runner instance. Never change it: a new key would not exclude an old deploy. */
export const MIGRATION_LOCK_KEY = 727001;

const defaultLogger: MigrationLogger = {
  info: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
};

function byName(a: MigrationFile, b: MigrationFile): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

async function applyOne(client: MigrationClient, file: MigrationFile, log: MigrationLogger): Promise<void> {
  log.info(`[migrate] applying ${file.name}`);
  await client.query('begin');
  try {
    await client.query(file.sql);
    await client.query('insert into cti_schema_migrations(filename) values ($1)', [file.name]);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    log.error(`[migrate] FAILED ${file.name}`);
    throw err;
  }
}

/** Returns the number of files applied in this run. */
export async function runMigrations(
  client: MigrationClient,
  files: ReadonlyArray<MigrationFile>,
  log: MigrationLogger = defaultLogger,
): Promise<number> {
  await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  try {
    await client.query(
      'create table if not exists cti_schema_migrations (filename text primary key, applied_at timestamptz not null default now())',
    );
    const { rows } = await client.query('select filename from cti_schema_migrations');
    const applied = new Set(rows.map((r) => String(r.filename)));
    let appliedCount = 0;
    for (const file of [...files].sort(byName)) {
      if (applied.has(file.name)) continue;
      await applyOne(client, file, log);
      appliedCount++;
    }
    log.info(`[migrate] done (${appliedCount} new of ${files.length} total)`);
    return appliedCount;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
  }
}
```

Replace everything in `packages/db/src/migrate.ts` below the `MIGRATIONS_DIR` constant with:
```ts
import { runMigrations } from './migrate-runner.js';

async function main(): Promise<void> {
  const names = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql'));
  const files = await Promise.all(
    names.map(async (name) => ({ name, sql: await readFile(join(MIGRATIONS_DIR, name), 'utf8') })),
  );
  const pool = getPool();
  const client = await pool.connect();
  try {
    await runMigrations(client, files);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```
(Move that `import` up with the other imports; delete the old `ensureTable` and `listApplied` functions.)

- [ ] **Step 4: Run to verify pass**

```bash
cd /Users/cdrshepard/spam-res-cti && npm -w packages/db run build && npm -w packages/db run test 2>&1 | tail -6 && npm -w services/cti-api run typecheck
```
Expected: db: 2 files, 6 tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti
git add packages/db
git commit -m "feat(db): serialize concurrent migration runs with a Postgres advisory lock

Two Railway services now run the pre-deploy migrate from one push; the runner
takes pg_advisory_lock(727001) around the applied-set read and the apply loop
so the second run finds nothing to do instead of racing the first. Runner
logic extracted to migrate-runner.ts and unit-tested with a recording client."
```

---

### Task 4: `packages/auth` (crypto + session, pure move + crypto tests)

**Files:**
- Create: `packages/auth/package.json`, `packages/auth/tsconfig.json`, `packages/auth/src/index.ts`, `packages/auth/src/crypto.test.ts`
- Move: `services/cti-api/src/crypto.ts` → `packages/auth/src/crypto.ts`; `services/cti-api/src/auth/session.ts` → `packages/auth/src/session.ts`
- Modify: root `package.json`, `services/cti-api/package.json`, `Dockerfile`, and the importers in `services/cti-api/src`: crypto (`routes/auth.ts`, `routes/inbound.ts`, `routes/mobile.ts`, `routes/telephony.ts`, `salesforce/client.ts`, `salesforce/oauth.ts`), session (`routes/admin.ts`, `routes/auth.ts`, `routes/calls.ts`, `routes/dialer.ts`, `routes/firewall.ts`, `routes/mobile.ts`, `routes/reputation.ts`, `routes/telephony.ts`), and the 5 tests that mock `auth/session.js` (`routes/admin-team.test.ts`, `routes/calls-disposition.test.ts`, `routes/dialer-handoffs.test.ts`, `routes/mobile.test.ts`, `routes/telephony-token.test.ts`)

**Interfaces:**
- Produces: `@cti/auth` exporting everything `crypto.ts` exported (`encryptString`, `decryptString`, `sha256`, `base64url`, `randomToken`, `constantTimeEquals`, `pkceVerifier`, `pkceChallenge`) and `session.ts` exported (`issueSession`, `resolveSession`, `revokeSession`) with unchanged signatures.
- The encryption key is read from `process.env.TOKEN_ENCRYPTION_KEY` at call time (64 hex chars; `cti-api`'s `config.ts` still validates it at boot).

- [ ] **Step 1: Package manifest**

`packages/auth/package.json`:
```json
{
  "name": "@cti/auth",
  "version": "0.1.0",
  "private": true,
  "description": "Sessions, token encryption, and tenancy helpers shared by every CTI service",
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
    "@cti/db": "*",
    "drizzle-orm": "^0.36.4"
  },
  "devDependencies": {
    "@types/node": "^20.17.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.5"
  }
}
```
`packages/auth/tsconfig.json`: identical to `packages/phone/tsconfig.json`.

- [ ] **Step 2: Move and adjust**

```bash
cd /Users/cdrshepard/spam-res-cti
mkdir -p packages/auth/src
git mv services/cti-api/src/crypto.ts packages/auth/src/crypto.ts
git mv services/cti-api/src/auth/session.ts packages/auth/src/session.ts
perl -pi -e "s#'\.\./db/index\.js'#'\@cti/db'#g; s#'\.\./crypto\.js'#'./crypto.js'#g" packages/auth/src/session.ts
grep -n "from '" packages/auth/src/session.ts
```
Expected imports: `'drizzle-orm'`, `'@cti/db'`, `'./crypto.js'`.

In `packages/auth/src/crypto.ts`, delete `import { loadConfig } from './config.js';` and replace the `key()` function with:
```ts
function key(): Buffer {
  const hex = process.env.TOKEN_ENCRYPTION_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}
```

`packages/auth/src/index.ts`:
```ts
export * from './crypto.js';
export * from './session.js';
```

- [ ] **Step 3: Write crypto tests (new coverage; none existed)**

`packages/auth/src/crypto.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  constantTimeEquals,
  decryptString,
  encryptString,
  pkceChallenge,
  randomToken,
  sha256,
} from './crypto.js';

const KEY = 'ab'.repeat(32);

beforeEach(() => vi.stubEnv('TOKEN_ENCRYPTION_KEY', KEY));
afterEach(() => vi.unstubAllEnvs());

describe('encryptString / decryptString', () => {
  it('round-trips utf8 text', () => {
    expect(decryptString(encryptString('refresh-token-ü'))).toBe('refresh-token-ü');
  });

  it('emits a v1 envelope with a fresh IV per call', () => {
    const a = encryptString('same');
    const b = encryptString('same');
    expect(a.split(':')).toHaveLength(4);
    expect(a.startsWith('v1:')).toBe(true);
    expect(a).not.toBe(b);
  });

  it('rejects tampered ciphertext', () => {
    const parts = encryptString('secret').split(':');
    parts[2] = Buffer.from('tampered-bytes').toString('base64');
    expect(() => decryptString(parts.join(':'))).toThrow();
  });

  it('rejects a malformed envelope', () => {
    expect(() => decryptString('not-an-envelope')).toThrow('Invalid ciphertext envelope');
  });

  it('fails loudly when the key is missing or malformed', () => {
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'short');
    expect(() => encryptString('x')).toThrow('TOKEN_ENCRYPTION_KEY must be 64 hex chars');
  });
});

describe('helpers', () => {
  it('sha256 matches the known vector for "abc"', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('randomToken is base64url with no padding', () => {
    const t = randomToken(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThanOrEqual(42);
  });

  it('constantTimeEquals compares equal and unequal strings', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
    expect(constantTimeEquals('abc', 'ab')).toBe(false);
  });

  it('pkceChallenge matches RFC 7636 appendix B', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});
```

- [ ] **Step 4: Wire manifests and rewrite consumers**

Root `package.json`: `"build:packages": "npm -w packages/phone run build && npm -w packages/db run build && npm -w packages/auth run build"`.
`services/cti-api/package.json`: add `"@cti/auth": "*"` to `dependencies`.
`Dockerfile`: add `COPY packages/auth/package.json packages/auth/package.json` after the db line.

```bash
cd /Users/cdrshepard/spam-res-cti && npm install && npm run build:packages
cd services/cti-api
perl -pi -e "s#'(\.\./)+crypto\.js'#'\@cti/auth'#g; s#'\./crypto\.js'#'\@cti/auth'#g; s#'(\.\./)+auth/session\.js'#'\@cti/auth'#g" $(grep -rlE "(crypto|auth/session)\.js'" src)
grep -rnE "(crypto|auth/session)\.js'" src || echo "OK: no relative auth imports remain"
grep -rn "vi.mock('@cti/auth'" src | wc -l
rmdir src/auth 2>/dev/null; ls src/auth 2>/dev/null || echo "OK: src/auth removed"
```
Expected: `OK: no relative auth imports remain`, `5`, `OK: src/auth removed`.

- [ ] **Step 5: Verify**

```bash
cd /Users/cdrshepard/spam-res-cti
npm -w packages/auth run test 2>&1 | tail -5 && npm -w services/cti-api run typecheck && npm -w services/cti-api run test 2>&1 | tail -5
```
Expected: auth: 1 file, 9 tests; typecheck clean; cti-api: **60 files, 769 tests**.

- [ ] **Step 6: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti
git add -A package.json package-lock.json packages/auth services/cti-api Dockerfile
git commit -m "refactor(packages): extract @cti/auth — sessions and token encryption

Pure move of crypto.ts and auth/session.ts. The AES key is read from
TOKEN_ENCRYPTION_KEY at call time (cti-api still validates it at boot). Adds
the first unit tests for the crypto helpers, including the RFC 7636 PKCE
vector. No behavior change."
```

---

### Task 5: `packages/firewall` part 1 — pure modules, rotation, reputation signals, calling window

**Files:**
- Create: `packages/firewall/package.json`, `packages/firewall/tsconfig.json`, `packages/firewall/src/index.ts` (interim), `packages/firewall/src/calling-window.ts`
- Move (with tests): `services/cti-api/src/firewall/{tz,state-calling-rules,warmup}.ts` → `packages/firewall/src/`; `services/cti-api/src/rotation.ts` → `packages/firewall/src/rotation.ts`; `services/cti-api/src/reputation/signals.ts` → `packages/firewall/src/reputation/signals.ts`; `services/cti-api/src/reputation/query.ts` → `packages/firewall/src/reputation/query.ts`
- Modify: `services/cti-api/src/dialer/pick-did.ts`, `services/cti-api/src/firewall/index.ts`, `services/cti-api/src/dialer/pick-agent-did.ts` (+ its test's mock), `services/cti-api/src/routes/calls.ts`, `services/cti-api/src/reputation/worker.ts`, `services/cti-api/src/firewall/calling-hours-drift.test.ts`, `services/cti-api/src/firewall/recipient-state-resolution.test.ts`, root `package.json`, `services/cti-api/package.json`, `Dockerfile`

**Interfaces:**
- Produces: `@cti/firewall` (interim) exporting everything from `tz.ts`, `state-calling-rules.ts`, `warmup.ts`, `rotation.ts` (`pickRotationNumber`, `AttemptCaps`), `reputation/signals.ts`, `reputation/query.ts` (`fetchDidWindowStats`), and the four calling-window constants `CALLING_HOUR_START = 8`, `CALLING_HOUR_END_INCLUSIVE = 20`, `CALLING_HOURS_START_HHMM = '08:00'`, `CALLING_HOURS_END_HHMM_EXCLUSIVE = '21:00'`.
- `dialer/pick-did.ts` re-exports those four constants so its existing importers are unchanged.

- [ ] **Step 1: Package manifest**

`packages/firewall/package.json`:
```json
{
  "name": "@cti/firewall",
  "version": "0.1.0",
  "private": true,
  "description": "Caller Reputation Firewall: pre-contact gates, rotation, warmup, state rules, reputation signals",
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
    "@cti/db": "*",
    "@cti/phone": "*",
    "drizzle-orm": "^0.36.4"
  },
  "devDependencies": {
    "@types/node": "^20.17.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.5"
  }
}
```
`packages/firewall/tsconfig.json`: identical to `packages/phone/tsconfig.json`.

- [ ] **Step 2: Move the pure modules and their tests**

```bash
cd /Users/cdrshepard/spam-res-cti
mkdir -p packages/firewall/src/reputation
for f in tz state-calling-rules warmup; do
  git mv services/cti-api/src/firewall/$f.ts packages/firewall/src/$f.ts
  git mv services/cti-api/src/firewall/$f.test.ts packages/firewall/src/$f.test.ts
done
git mv services/cti-api/src/rotation.ts packages/firewall/src/rotation.ts
git mv services/cti-api/src/rotation.test.ts packages/firewall/src/rotation.test.ts
git mv services/cti-api/src/reputation/signals.ts packages/firewall/src/reputation/signals.ts
git mv services/cti-api/src/reputation/signals.test.ts packages/firewall/src/reputation/signals.test.ts
git mv services/cti-api/src/reputation/query.ts packages/firewall/src/reputation/query.ts
perl -pi -e "s#'\./db/index\.js'#'\@cti/db'#g; s#'\./firewall/warmup\.js'#'./warmup.js'#g; s#'\./firewall/tz\.js'#'./tz.js'#g" packages/firewall/src/rotation.ts
perl -pi -e "s#'\.\./db/index\.js'#'\@cti/db'#g" packages/firewall/src/reputation/query.ts
grep -n "from '" packages/firewall/src/rotation.ts packages/firewall/src/reputation/query.ts
```
Expected: rotation imports `'drizzle-orm'`, `'@cti/db'` (×2), `'./warmup.js'`, `'./tz.js'`; query imports `'drizzle-orm'`, `'@cti/db'` (×2), `'./signals.js'`.

- [ ] **Step 3: Create `calling-window.ts` from the dialer's constants**

`packages/firewall/src/calling-window.ts` (the comment is the original from `dialer/pick-did.ts` lines 36–51, kept because it records the incident):
```ts
/**
 * THE recipient-local calling window, for the whole system: dialing is allowed
 * while the local hour is in [8, 20] — 08:00:00 through 20:59:59, i.e. 8:00am
 * through 8:59pm. That sits inside the federal TCPA bound of 8am–9pm with a
 * one-minute margin at the top.
 *
 * ONE definition, two enforcement sites. The dialer's coarse pre-filter
 * (`withinCallingHours` in dialer/pick-did.ts) and the firewall's authoritative
 * click-to-dial gate used to carry independent literals — 8am–9pm here,
 * 8am–8pm there — so a call the firewall would BLOCK at 8:10pm local could
 * still be attempted by the power dialer at that same instant, with nothing
 * keeping the two from drifting further (spam-defense audit §5, gap 1). Both
 * now import these constants, so neither site can move without the other.
 *
 * A campaign row may still NARROW the window (org business preference); it can
 * no longer widen it past this pair.
 */
export const CALLING_HOUR_START = 8;
export const CALLING_HOUR_END_INCLUSIVE = 20;

/** The same window as the `HH:MM` strings `campaign_configs` stores. The end is
 *  the EXCLUSIVE bound the firewall's minute comparator wants, so the whole of
 *  hour `CALLING_HOUR_END_INCLUSIVE` (through :59) is inside it — exactly what
 *  `withinCallingHours` allows. */
const hhmm = (hour: number): string => `${String(hour).padStart(2, '0')}:00`;
export const CALLING_HOURS_START_HHMM = hhmm(CALLING_HOUR_START);
export const CALLING_HOURS_END_HHMM_EXCLUSIVE = hhmm(CALLING_HOUR_END_INCLUSIVE + 1);
```

`packages/firewall/src/index.ts` (interim — Task 6 replaces it):
```ts
export * from './calling-window.js';
export * from './tz.js';
export * from './state-calling-rules.js';
export * from './warmup.js';
export * from './rotation.js';
export * from './reputation/signals.js';
export * from './reputation/query.js';
```

- [ ] **Step 4: Rewire `dialer/pick-did.ts`**

Delete lines 36–62 of `services/cti-api/src/dialer/pick-did.ts` (the doc comment, `CALLING_HOUR_START`, `CALLING_HOUR_END_INCLUSIVE`, the `hhmm` helper, `CALLING_HOURS_START_HHMM`, `CALLING_HOURS_END_HHMM_EXCLUSIVE`). Replace its three `../firewall/*.js` imports with one import plus a re-export:
```ts
import {
  CALLING_HOUR_END_INCLUSIVE,
  CALLING_HOUR_START,
  CALLING_HOURS_END_HHMM_EXCLUSIVE,
  CALLING_HOURS_START_HHMM,
  effectiveCallingWindow,
  resolveStateRule,
  stateForAreaCode,
  timezoneForNumber,
  todayIsoWeekday,
  warmupCapForAge,
} from '@cti/firewall';

// The system calling window lives in @cti/firewall (calling-window.ts) so the
// firewall gate and this pre-filter cannot drift. Re-exported here so the
// dialer's callers and the drift interlock test keep one import site.
export { CALLING_HOUR_END_INCLUSIVE, CALLING_HOUR_START, CALLING_HOURS_END_HHMM_EXCLUSIVE, CALLING_HOURS_START_HHMM };
```
```bash
grep -n "hhmm\b" services/cti-api/src/dialer/pick-did.ts
```
Expected: only the FIX-10 comment line mentions `hhmm`; no definition remains.

- [ ] **Step 5: Wire manifests and rewrite remaining consumers**

Root `package.json`: `"build:packages": "npm -w packages/phone run build && npm -w packages/db run build && npm -w packages/auth run build && npm -w packages/firewall run build"`.
`services/cti-api/package.json`: add `"@cti/firewall": "*"` to `dependencies`.
`Dockerfile`: add `COPY packages/firewall/package.json packages/firewall/package.json` after the auth line.

```bash
cd /Users/cdrshepard/spam-res-cti && npm install && npm run build:packages
cd services/cti-api
# firewall/index.ts, routes/calls.ts, pick-agent-did(+test), worker, and the two firewall tests that import siblings
perl -pi -e "s#'(\.\./)+firewall/(tz|warmup|state-calling-rules)\.js'#'\@cti/firewall'#g; s#'(\.\./)+rotation\.js'#'\@cti/firewall'#g; s#'(\.\./)+reputation/(query|signals)\.js'#'\@cti/firewall'#g; s#'(\.\./)+dialer/pick-did\.js'#'\@cti/firewall'#g if m#^import .*CALLING_HOURS#" $(grep -rlE "(firewall/(tz|warmup|state-calling-rules)|rotation|reputation/(query|signals)|dialer/pick-did)\.js'" src)
perl -pi -e "s#'\./(tz|warmup|state-calling-rules)\.js'#'\@cti/firewall'#g" src/firewall/index.ts src/firewall/calling-hours-drift.test.ts src/firewall/recipient-state-resolution.test.ts
perl -pi -e "s#'\./(query|signals)\.js'#'\@cti/firewall'#g" src/reputation/worker.ts
grep -rnE "(firewall/(tz|warmup|state-calling-rules)|/rotation|reputation/(query|signals))\.js'" src || echo "OK: pure firewall modules no longer imported relatively"
grep -n "pick-did" src/firewall/index.ts || echo "OK: firewall no longer imports the dialer"
grep -n "vi.mock('@cti/firewall'" src/dialer/pick-agent-did.test.ts
```
Expected: both `OK:` lines; the last grep shows the partial mock now targets `@cti/firewall` (it spreads `importOriginal`, so the other exports stay real).

Note: `src/firewall/calling-hours-drift.test.ts` still imports `withinCallingHours` and the constants from `'../dialer/pick-did.js'` — that line does not match the `CALLING_HOURS` guard because it is a multi-line import; confirm with `grep -n "pick-did" src/firewall/calling-hours-drift.test.ts` → the `from '../dialer/pick-did.js'` line remains. That is intended (Task 6 moves the file).

- [ ] **Step 6: Verify**

```bash
cd /Users/cdrshepard/spam-res-cti
npm -w packages/firewall run test 2>&1 | tail -5 && npm -w services/cti-api run typecheck && npm -w services/cti-api run test 2>&1 | tail -5
```
Expected: firewall: 5 files, 70 tests; typecheck clean; cti-api: **55 files, 699 tests**.

- [ ] **Step 7: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti
git add -A package.json package-lock.json packages/firewall services/cti-api Dockerfile
git commit -m "refactor(packages): extract @cti/firewall part 1 — tz, state rules, warmup, rotation, reputation signals

Pure move of the firewall's pure modules, the rotation picker, and the
reputation window query/signals. The system calling-window constants move out
of dialer/pick-did.ts into the package (pick-did re-exports them), removing the
firewall -> dialer import. No behavior change."
```

---

### Task 6: `packages/firewall` part 2 — split `index.ts`, inject the recipient-address port, move tests

**Files:**
- Create in `packages/firewall/src/`: `types.ts`, `errors.ts`, `reasons.ts`, `aggregate.ts`, `attempts.ts`, `recipient.ts`, `velocity.ts`, `calling-hours.ts`, `evaluate.ts`, `evaluate.test.ts`; replace `index.ts`
- Create: `services/cti-api/src/firewall/recipient-address.ts`
- Move tests: `services/cti-api/src/firewall/{aggregate,attempts,calling-hours-gate,calling-hours-message,gate7d-hours-label,recipient-state-resolution,velocity}.test.ts` → `packages/firewall/src/`; `services/cti-api/src/firewall/calling-hours-drift.test.ts` → `services/cti-api/src/dialer/calling-hours-drift.test.ts`
- Delete: `services/cti-api/src/firewall/index.ts`
- Modify: `services/cti-api/src/routes/firewall.ts`, `services/cti-api/src/routes/reputation.ts`, `services/cti-api/src/dialer/pick-agent-did.ts`

**Interfaces:**
- Produces: `evaluate(db: Db, input: FirewallInput, deps?: FirewallDeps): Promise<FirewallResponse>` — same behavior; the optional third argument replaces the direct Salesforce import.
- Produces: `FirewallDeps { fetchRecipientAddress?: (userId: string, recordId: string) => Promise<RecipientAddress | null> }`, `RecipientAddress { state: string | null; country: string | null; postalCode?: string | null; objectType: string }`, `class RecipientLookupUnauthorizedError extends Error` (name `'RecipientLookupUnauthorizedError'`).
- Produces: every previously exported symbol of `firewall/index.ts` (`Decision`, `FirewallInput`, `CheckResult`, `FirewallResponse`, `tallyAttempts`, `customerAttemptCounts`, `atCustomerCeiling`, `attemptGateChecks`, `resolveRecipientState`, `enforcedStateHoursLabel`, `evaluate`, `aggregate`, `velocityGateCheck`, `callingWindowFor`, `CallingHoursVerdict`, `callingHoursVerdict`, `isWithinCallingHours`, `formatAllowedDays`, `callingHoursBlockDetail`, `callingHoursGateCheck`, `warmupCapForAge`) plus `REASON`.
- Consumes: `services/cti-api/src/salesforce/client.ts` `fetchRecordAddress(userId, recordId): Promise<RecordAddress | null>` and `SalesforceUnauthorizedError` (in the adapter only).

- [ ] **Step 1: Snapshot the original for copying**

```bash
cd /Users/cdrshepard/spam-res-cti
git show 411af3a:services/cti-api/src/firewall/index.ts > /tmp/firewall-original.ts
wc -l /tmp/firewall-original.ts
```
Expected: `1350`.

- [ ] **Step 2: Create the small modules** (each body is copied verbatim from `/tmp/firewall-original.ts` at the ranges given; only the import headers are new)

`packages/firewall/src/types.ts` — lines 26–62 (`Decision`, `FirewallInput`, `CheckResult`, `FirewallResponse`), preceded by:
```ts
import type { Db } from '@cti/db';

export type { Db };
```
and followed by:
```ts
/** What the recipient-address port returns: enough to derive timezone and state. */
export interface RecipientAddress {
  state: string | null;
  country: string | null;
  postalCode?: string | null;
  /** Free-form label used in the audit detail, e.g. "Lead" or "Contact". */
  objectType: string;
}

/**
 * Outward dependencies of `evaluate`, injected by the hosting service so the
 * package has no CRM import. When `fetchRecipientAddress` is absent,
 * `FirewallInput.recipientRecordId` is ignored and timezone/state fall back to
 * the dialed number's area code exactly as when no record id is supplied.
 */
export interface FirewallDeps {
  fetchRecipientAddress?: (userId: string, recordId: string) => Promise<RecipientAddress | null>;
}
```

`packages/firewall/src/errors.ts`:
```ts
/**
 * Thrown by a `FirewallDeps.fetchRecipientAddress` adapter when the hosting
 * service's CRM connection is missing or revoked. `evaluate` logs it as a
 * skipped lookup (not a failure) and continues with the area-code fallback.
 */
export class RecipientLookupUnauthorizedError extends Error {
  constructor() {
    super('Recipient address lookup not authorized');
    this.name = 'RecipientLookupUnauthorizedError';
  }
}
```

`packages/firewall/src/reasons.ts` — lines 66–118 (the `REASON` object), changed to `export const REASON = {` … `} as const;`.

`packages/firewall/src/aggregate.ts` — lines 987–1020 (`aggregate`), preceded by:
```ts
import type { CheckResult, Decision } from './types.js';
```

`packages/firewall/src/attempts.ts` — from the `/**` doc comment that precedes `export function tallyAttempts` (line 148) through the closing `}` of `attemptGateChecks` (line 296), preceded by:
```ts
import { and, eq, gte, sql } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { REASON } from './reasons.js';
import type { CheckResult } from './types.js';
```

`packages/firewall/src/recipient.ts` — from the `/**` FIX-3 comment before `resolveRecipientState` (line 297) through the closing `}` of `enforcedStateHoursLabel` (line 334), preceded by:
```ts
import { resolveStateRule, todayIsoWeekday, type IsoWeekday } from './state-calling-rules.js';
import { stateForAreaCode } from './tz.js';
```

`packages/firewall/src/velocity.ts` — from the `/**` comment that begins "Ten dials a minute" (line 1078) through the closing `}` of `velocityGateCheck` (line 1118), preceded by:
```ts
import { REASON } from './reasons.js';
import type { CheckResult } from './types.js';
```

`packages/firewall/src/calling-hours.ts` — two ranges, in this order: the `callingWindowFor` doc comment (lines 1048–1064, the block beginning "The window gate 6 actually enforces"), then lines 1120–1350 (from the `hhmmToMinutes` doc comment through the end of `callingHoursGateCheck`), preceded by:
```ts
import { CALLING_HOURS_END_HHMM_EXCLUSIVE, CALLING_HOURS_START_HHMM } from './calling-window.js';
import { REASON } from './reasons.js';
import { effectiveCallingWindow, resolveStateRule, todayIsoWeekday, type IsoWeekday } from './state-calling-rules.js';
import type { CheckResult } from './types.js';
```

- [ ] **Step 3: Create `evaluate.ts`** — header below, then verbatim: `attestationRank` with its doc (lines 119–130), the DNC cache block (lines 132–157, `dncLoadedCache`, `DNC_LOADED_TTL_MS`, `isDncListLoaded`), `evaluate` (lines 336–985), `persistAndReturn` (lines 1022–1046). Then apply the four edits.

Header:
```ts
/**
 * Caller Reputation Firewall — pre-call decision engine.
 *
 * Returns ALLOW / BLOCK / REQUIRE_REVIEW with a reasons array, evidence per
 * check, and an auditId for traceability. Every decision is persisted to
 * pre_call_audits so we can show the rep _why_ and prove what we knew at
 * the time of the decision.
 *
 * This DOES NOT claim legal compliance. It enforces internal guardrails.
 */
import { and, eq, gte, ne, sql } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { normalize } from '@cti/phone';
import { aggregate } from './aggregate.js';
import { attemptGateChecks, customerAttemptCounts } from './attempts.js';
import { callingHoursGateCheck, callingWindowFor } from './calling-hours.js';
import { RecipientLookupUnauthorizedError } from './errors.js';
import { REASON } from './reasons.js';
import { enforcedStateHoursLabel, resolveRecipientState } from './recipient.js';
import { fetchDidWindowStats } from './reputation/query.js';
import { answerRateBreach, engagementBreach, THRESHOLDS } from './reputation/signals.js';
import { pickRotationNumber } from './rotation.js';
import { resolveTimezone, stateForAreaCode, timezoneForNumber } from './tz.js';
import type { CheckResult, FirewallDeps, FirewallInput, FirewallResponse } from './types.js';
import { velocityGateCheck } from './velocity.js';
import { warmupCapForAge } from './warmup.js';
```

Edit A — signature:
```ts
export async function evaluate(db: Db, input: FirewallInput, deps: FirewallDeps = {}): Promise<FirewallResponse> {
```

Edit B — the timezone lookup block. Original:
```ts
  if (!resolvedTz && input.recipientRecordId) {
    try {
      const addr = await fetchRecordAddress(input.userId, input.recipientRecordId);
```
becomes:
```ts
  if (!resolvedTz && input.recipientRecordId && deps.fetchRecipientAddress) {
    try {
      const addr = await deps.fetchRecipientAddress(input.userId, input.recipientRecordId);
```
and in the same block's `catch`, `if (err instanceof SalesforceUnauthorizedError) {` becomes `if (err instanceof RecipientLookupUnauthorizedError) {` and the two log strings change `SF address lookup` to `recipient address lookup`.

Edit C — gate 7d. Original:
```ts
  if (input.recipientRecordId) {
    try {
      const addr = await fetchRecordAddress(input.userId, input.recipientRecordId);
```
becomes:
```ts
  if (input.recipientRecordId && deps.fetchRecipientAddress) {
    try {
      const addr = await deps.fetchRecipientAddress(input.userId, input.recipientRecordId);
```

Edit D — remove the local `type Db = ReturnType<typeof getDb>;` line if it was copied (the type now comes from `@cti/db`).

```bash
grep -nE "fetchRecordAddress|SalesforceUnauthorizedError|getDb" packages/firewall/src/evaluate.ts || echo "OK: no Salesforce or getDb references"
wc -l packages/firewall/src/evaluate.ts
```
Expected: `OK: …`; roughly 720 lines (under the 800 cap).

- [ ] **Step 4: Final `index.ts`**

```ts
export * from './types.js';
export { RecipientLookupUnauthorizedError } from './errors.js';
export { REASON } from './reasons.js';
export { aggregate } from './aggregate.js';
export { atCustomerCeiling, attemptGateChecks, customerAttemptCounts, tallyAttempts } from './attempts.js';
export { enforcedStateHoursLabel, resolveRecipientState } from './recipient.js';
export { evaluate } from './evaluate.js';
export { velocityGateCheck } from './velocity.js';
export * from './calling-hours.js';
export * from './calling-window.js';
export * from './tz.js';
export * from './state-calling-rules.js';
export * from './warmup.js';
export * from './rotation.js';
export * from './reputation/signals.js';
export * from './reputation/query.js';
```

- [ ] **Step 5: The adapter in `cti-api` and the route**

`services/cti-api/src/firewall/recipient-address.ts`:
```ts
/**
 * Adapts the Salesforce record lookup to the firewall's recipient-address port.
 * The firewall package has no CRM import; this is the only place the two meet.
 */
import { RecipientLookupUnauthorizedError, type FirewallDeps } from '@cti/firewall';
import { fetchRecordAddress, SalesforceUnauthorizedError } from '../salesforce/client.js';

export const fetchRecipientAddress: NonNullable<FirewallDeps['fetchRecipientAddress']> = async (userId, recordId) => {
  try {
    return await fetchRecordAddress(userId, recordId);
  } catch (err) {
    if (err instanceof SalesforceUnauthorizedError) throw new RecipientLookupUnauthorizedError();
    throw err;
  }
};

export const firewallDeps: FirewallDeps = { fetchRecipientAddress };
```

`services/cti-api/src/routes/firewall.ts`: change `import { evaluate } from '../firewall/index.js';` to
```ts
import { evaluate } from '@cti/firewall';
import { firewallDeps } from '../firewall/recipient-address.js';
```
and the call to `const result = await evaluate(db, { …unchanged… }, firewallDeps);`.

- [ ] **Step 6: Move tests, delete the old file, rewrite the last imports**

```bash
cd /Users/cdrshepard/spam-res-cti
for f in aggregate attempts calling-hours-gate calling-hours-message gate7d-hours-label recipient-state-resolution velocity; do
  git mv services/cti-api/src/firewall/$f.test.ts packages/firewall/src/$f.test.ts
done
# inside the package, self-imports must be relative (a package-name import would hit stale dist)
perl -pi -e "s#'\@cti/firewall'#'./index.js'#g; s#'\@cti/db'#'\@cti/db'#g" packages/firewall/src/*.test.ts
git mv services/cti-api/src/firewall/calling-hours-drift.test.ts services/cti-api/src/dialer/calling-hours-drift.test.ts
perl -pi -e "s#'\./index\.js'#'\@cti/firewall'#g; s#'\.\./dialer/pick-did\.js'#'./pick-did.js'#g" services/cti-api/src/dialer/calling-hours-drift.test.ts
git rm -q services/cti-api/src/firewall/index.ts
cd services/cti-api
perl -pi -e "s#'(\.\./)+firewall/index\.js'#'\@cti/firewall'#g" src/routes/reputation.ts src/dialer/pick-agent-did.ts
grep -rn "firewall/index\.js'" src || echo "OK: firewall/index no longer imported"
ls src/firewall/
```
Expected: `OK: …`; `src/firewall/` contains only `recipient-address.ts`.

- [ ] **Step 7: Characterization test for `evaluate` (new; the old file had none)**

`packages/firewall/src/evaluate.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@cti/db';
import { RecipientLookupUnauthorizedError } from './errors.js';
import { evaluate } from './evaluate.js';

/**
 * Minimal fake DB in the repo's convention: `where` clauses are not
 * introspected; each query returns the fixture configured for its table.
 * Shape covers exactly what `evaluate` touches when no campaign row exists,
 * which is the smallest path that still exercises the recipient-address port,
 * the DNC/consent gates, and the audit insert.
 */
function fakeDb() {
  const inserted: unknown[] = [];
  const findFirst = <T,>(value: T) => async () => value;
  const db = {
    query: {
      optOuts: { findFirst: findFirst(undefined) },
      blockedNumbers: { findFirst: findFirst(undefined) },
      campaignConfigs: { findFirst: findFirst(undefined) },
      outboundNumbers: { findFirst: findFirst(undefined) },
      stateCallingRules: { findFirst: findFirst(undefined) },
      federalDncEntries: { findFirst: findFirst(undefined) },
      organizations: { findFirst: findFirst({ dncMode: 'registry' }) },
      consentRecords: { findFirst: findFirst(undefined) },
      rndLookups: { findFirst: findFirst(undefined) },
    },
    // rotation's pool query: db.select().from(t).where(...) awaited directly
    select: () => ({ from: () => ({ where: async () => [] }) }),
    insert: () => ({
      values: (v: unknown) => {
        inserted.push(v);
        return { returning: async () => [{ id: 'audit-1' }] };
      },
    }),
  };
  return { db: db as unknown as Db, inserted };
}

const base = { orgId: 'O1', userId: 'U1' };

afterEach(() => vi.restoreAllMocks());

describe('evaluate — characterization', () => {
  it('BLOCKs an unparseable number, persists the audit, and never consults the port', async () => {
    const { db, inserted } = fakeDb();
    const port = vi.fn();
    const res = await evaluate(db, { ...base, toNumberRaw: 'not-a-number', recipientRecordId: '00Q000000000001AAA' }, { fetchRecipientAddress: port });
    expect(res.decision).toBe('BLOCK');
    expect(res.checks[0]).toMatchObject({ name: 'phone_parse', reasonCode: 'PHONE_INVALID' });
    expect(res.auditId).toBe('audit-1');
    expect(res.normalizedTo).toBeNull();
    expect(inserted).toHaveLength(1);
    expect(port).not.toHaveBeenCalled();
  });

  it('with no campaign and no numbers returns REQUIRE_REVIEW with the expected gate set', async () => {
    const { db } = fakeDb();
    const res = await evaluate(db, { ...base, toNumberRaw: '(619) 555-9999' });
    expect(res.decision).toBe('REQUIRE_REVIEW');
    expect(res.normalizedTo).toBe('+16195559999');
    const byName = Object.fromEntries(res.checks.map((c) => [c.name, c.reasonCode]));
    expect(byName).toMatchObject({
      phone_parse: 'PHONE_PARSED',
      opt_out: 'NOT_OPTED_OUT',
      blocklist: 'NOT_BLOCKED',
      campaign: 'CAMPAIGN_MISSING',
      outbound_number: 'OUTBOUND_NUMBER_MISSING',
      federal_dnc: 'FEDERAL_DNC_NOT_LOADED',
      consent_record: 'TCPA_CONSENT_NOT_FOUND',
      recording_consent: 'RECORDING_CONSENT_OK',
    });
  });

  it('consults the recipient-address port for timezone and again for state rules', async () => {
    const { db } = fakeDb();
    const port = vi.fn(async () => ({ state: 'CA', country: 'US', postalCode: null, objectType: 'Lead' }));
    await evaluate(db, { ...base, toNumberRaw: '+16195559999', recipientRecordId: '00Q000000000001AAA' }, { fetchRecipientAddress: port });
    expect(port).toHaveBeenCalledTimes(2);
    expect(port).toHaveBeenCalledWith('U1', '00Q000000000001AAA');
  });

  it('ignores recipientRecordId when no port is supplied', async () => {
    const { db } = fakeDb();
    const res = await evaluate(db, { ...base, toNumberRaw: '+16195559999', recipientRecordId: '00Q000000000001AAA' });
    expect(res.decision).toBe('REQUIRE_REVIEW');
  });

  it('treats an unauthorized lookup as skipped, not fatal', async () => {
    const { db } = fakeDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const port = vi.fn(async () => { throw new RecipientLookupUnauthorizedError(); });
    const res = await evaluate(db, { ...base, toNumberRaw: '+16195559999', recipientRecordId: '00Q000000000001AAA' }, { fetchRecipientAddress: port });
    expect(res.decision).toBe('REQUIRE_REVIEW');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not authorized'), expect.objectContaining({ userId: 'U1' }));
  });
});
```

- [ ] **Step 8: Verify**

```bash
cd /Users/cdrshepard/spam-res-cti
npm run build:packages && npm -w packages/firewall run test 2>&1 | tail -5 && npm -w services/cti-api run typecheck && npm -w services/cti-api run test 2>&1 | tail -5
```
Expected: firewall: 13 files, 121 tests (70 + 46 moved + 5 new); typecheck clean; cti-api: **48 files, 653 tests** (the drift interlock's 11 tests now run from `dialer/`).

- [ ] **Step 9: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti
git add -A packages/firewall services/cti-api
git commit -m "refactor(firewall): move evaluate into @cti/firewall, split pure helpers per module, inject the recipient-address port

firewall/index.ts (1,350 lines) becomes types/reasons/aggregate/attempts/
recipient/velocity/calling-hours/evaluate modules in the package, every
previously exported symbol re-exported unchanged. The one CRM dependency
(Salesforce fetchRecordAddress) is now an injected FirewallDeps port; cti-api
supplies it from firewall/recipient-address.ts. Adds a characterization test
for evaluate() — the first coverage of the full pipeline. No behavior change."
```

---

### Task 7: Deploy wiring check, docs, and Docker build verification

**Files:**
- Modify: `README.md`, `DEPLOY.md`, `docs/superpowers/specs/2026-09-03-outreach-foundation-design.md` (two one-line corrections)
- Verify: `Dockerfile`, `railway.json`

- [ ] **Step 1: Docker build must succeed with the new layout**

```bash
cd /Users/cdrshepard/spam-res-cti && docker build -t cti-api-extraction-check . 2>&1 | tail -5 && docker run --rm cti-api-extraction-check node -e "import('/app/services/cti-api/dist/server.js').catch(e => { console.log('boot reached config validation:', /environment|DATABASE_URL|TOKEN_ENCRYPTION_KEY/.test(String(e)) ); process.exit(0) })" ; docker run --rm cti-api-extraction-check ls packages/db/migrations | tail -1
```
Expected: build completes; the boot probe prints `Fatal startup error: Invalid environment configuration …` from `server.ts`'s own `main().catch` (it exits before the wrapper's `.catch` runs; the missing env is the expected failure, and reaching it proves module resolution of `@cti/*` works in the image); last migration filename listed is `0035_mobile_voip_token.sql`.

- [ ] **Step 2: README**

In `README.md`:
- Architecture block: add under `services/`:
  ```
  packages/
    db/                  Drizzle schema, Postgres pool, SQL migrations (advisory-locked runner)
    phone/               E.164 normalization
    auth/                sessions, token encryption
    firewall/            Caller Reputation Firewall, rotation, warmup, state rules, reputation signals
  ```
- First-run setup step 4: `npm run migrate` is unchanged; add a sentence: "Packages build automatically before `dev:api`, `typecheck`, `test`, and `build:api`; run `npm run build:packages` by hand after editing a package while `tsx watch` is running."
- Replace `services/cti-api/src/firewall/index.ts` with `packages/firewall/src/evaluate.ts` in the Caller Reputation Firewall section.
- Project layout tree: move `db/`, `firewall/`, `rotation.ts`, `phone.ts`, `crypto.ts`, `auth/`, `reputation/{query,signals}.ts`, `migrations/` under a new `packages/` entry; keep `reputation/worker.ts` under `cti-api`.

In `DEPLOY.md`, step 6 sentence "Migrations run on every boot." → "Migrations run as the pre-deploy step (`npm --workspace packages/db run migrate`), under an advisory lock so multiple services deploying from one push serialize."

- [ ] **Step 3: Spec corrections** (the spec was written before the extraction was planned in detail)

In `docs/superpowers/specs/2026-09-03-outreach-foundation-design.md`:
- §3.1 "Firewall split" bullet: replace with "**Firewall split, two passes.** Pass one (this plan): `firewall/index.ts` becomes `types`, `reasons`, `aggregate`, `attempts`, `recipient`, `velocity`, `calling-hours`, `calling-window`, and `evaluate` modules with every export unchanged, and the Salesforce lookup becomes an injected `FirewallDeps` port. Pass two (rollout step 5, with channel/actor): the inline gates in `evaluate` become `gates/<name>.ts` exporting `{ name, channels, run }`, which is when applicability is introduced and tested."
- §13 step 1: remove ", `packages/contracts` (empty shell)" — the contracts package is created in the plan that first gives it content.

- [ ] **Step 4: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti
git add README.md DEPLOY.md docs/superpowers/specs/2026-09-03-outreach-foundation-design.md
git commit -m "docs(packages): document the packages layout, package build step, and locked pre-deploy migrate"
```

---

### Task 8: Tenancy migration, schema, and `createTenant` (TDD)

**Files:**
- Create: `packages/db/migrations/0036_tenancy.sql`, `packages/auth/src/tenancy.ts`, `packages/auth/src/tenancy.test.ts`
- Modify: `packages/db/src/schema.ts`, `packages/auth/src/index.ts`

**Interfaces:**
- Produces (schema): `organizations.{slug, timezone, settings, status, workosOrgId}`; `users.{kind, externalAuthId, isSuperAdmin}`; unique `(org_id, email)` replaces global email uniqueness; type `UserKind = 'human' | 'service'`.
- Produces (`@cti/auth`): `slugify(name: string): string`; `aiAgentEmail(slug: string): string`; `AI_AGENT_DISPLAY_NAME = 'AI Agent'`; `createTenant(db: Db, input: CreateTenantInput): Promise<CreatedTenant>` where `CreateTenantInput { name: string; slug?: string; timezone?: string; sfOrgId?: string | null }` and `CreatedTenant { org: Organization; aiAgentUserId: string }`.

- [ ] **Step 1: Write the failing tests**

`packages/auth/src/tenancy.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { schema, type Db } from '@cti/db';
import { AI_AGENT_DISPLAY_NAME, aiAgentEmail, createTenant, slugify } from './tenancy.js';

describe('slugify', () => {
  it('lowercases and collapses non-alphanumerics to single dashes', () => {
    expect(slugify('GG Homes')).toBe('gg-homes');
    expect(slugify('Salesforce Org 00Dxx0000001234')).toBe('salesforce-org-00dxx0000001234');
    expect(slugify('  A -- B!! ')).toBe('a-b');
  });
  it('returns an empty string when nothing survives', () => {
    expect(slugify('---')).toBe('');
  });
});

function fakeDb(opts: { slugTaken?: boolean } = {}) {
  const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const tx = {
    query: { organizations: { findFirst: async () => (opts.slugTaken ? { id: 'existing' } : undefined) } },
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        const row = { id: `id-${inserts.length}`, ...values };
        return { returning: async () => [row], onConflictDoNothing: async () => undefined };
      },
    }),
  };
  const db = { ...tx, transaction: async <T,>(fn: (t: typeof tx) => Promise<T>) => fn(tx) };
  return { db: db as unknown as Db, inserts };
}

describe('createTenant', () => {
  it('creates the org, its AI Agent service user, and the default campaign in one transaction', async () => {
    const { db, inserts } = fakeDb();
    const out = await createTenant(db, { name: 'GG Homes', sfOrgId: '00Dxx0000001234' });
    expect(inserts.map((i) => i.table)).toEqual([schema.organizations, schema.users, schema.campaignConfigs]);
    expect(inserts[0]!.values).toMatchObject({ name: 'GG Homes', slug: 'gg-homes', timezone: 'America/Los_Angeles', sfOrgId: '00Dxx0000001234' });
    expect(inserts[1]!.values).toMatchObject({ orgId: 'id-1', kind: 'service', displayName: AI_AGENT_DISPLAY_NAME, email: 'ai-agent@gg-homes.internal', timezone: 'America/Los_Angeles' });
    expect(inserts[2]!.values).toMatchObject({ orgId: 'id-1', key: 'default', name: 'Default Campaign' });
    expect(out.org.slug).toBe('gg-homes');
    expect(out.aiAgentUserId).toBe('id-2');
  });

  it('honors an explicit slug and timezone', async () => {
    const { db, inserts } = fakeDb();
    await createTenant(db, { name: 'Whatever', slug: 'Custom Slug', timezone: 'America/Chicago' });
    expect(inserts[0]!.values).toMatchObject({ slug: 'custom-slug', timezone: 'America/Chicago' });
  });

  it('appends a random suffix when the slug is taken, and the agent email follows', async () => {
    const { db, inserts } = fakeDb({ slugTaken: true });
    const out = await createTenant(db, { name: 'GG Homes' });
    expect(out.org.slug).toMatch(/^gg-homes-[0-9a-f]{6}$/);
    expect(inserts[1]!.values.email).toBe(aiAgentEmail(out.org.slug));
  });

  it("falls back to 'org' when the name yields no slug", async () => {
    const { db, inserts } = fakeDb();
    await createTenant(db, { name: '!!!' });
    expect(inserts[0]!.values.slug).toBe('org');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/cdrshepard/spam-res-cti && npm -w packages/auth run test 2>&1 | tail -6
```
Expected: FAIL — cannot resolve `./tenancy.js`.

- [ ] **Step 3: Migration**

`packages/db/migrations/0036_tenancy.sql`:
```sql
-- =============================================================================
-- 0036_tenancy.sql — organizations become real tenants; users get kind /
-- external auth id / super-admin; email uniqueness moves from global to
-- per-tenant; every existing org gets an "AI Agent" service user.
-- Spec: docs/superpowers/specs/2026-09-03-outreach-foundation-design.md §4
-- =============================================================================

alter table organizations add column if not exists slug text;
alter table organizations add column if not exists timezone text not null default 'America/Los_Angeles';
alter table organizations add column if not exists settings jsonb not null default '{}'::jsonb;
alter table organizations add column if not exists status text not null default 'active';
alter table organizations add column if not exists workos_org_id text;

-- Backfill slugs from names: lowercase, runs of non-alphanumerics -> '-', trimmed.
update organizations
   set slug = trim(both '-' from lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g')))
 where slug is null;
-- Empty results and collisions (all but the lowest id in a group) get 8 chars of the id.
update organizations o
   set slug = coalesce(nullif(o.slug, ''), 'org') || '-' || left(o.id::text, 8)
 where o.slug = ''
    or exists (select 1 from organizations x where x.slug = o.slug and x.id < o.id);

alter table organizations alter column slug set not null;
create unique index if not exists organizations_slug_unique on organizations (slug);
create unique index if not exists organizations_workos_org_id_unique
  on organizations (workos_org_id) where workos_org_id is not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_status_check') then
    alter table organizations add constraint organizations_status_check check (status in ('active', 'suspended'));
  end if;
end $$;

alter table users add column if not exists kind text not null default 'human';
alter table users add column if not exists external_auth_id text;
alter table users add column if not exists is_super_admin boolean not null default false;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'users_kind_check') then
    alter table users add constraint users_kind_check check (kind in ('human', 'service'));
  end if;
end $$;

-- Per-tenant email uniqueness (the same person may be a user in two tenants).
drop index if exists users_email_unique;
create unique index if not exists users_org_email_unique on users (org_id, email);
create unique index if not exists users_external_auth_id_unique
  on users (external_auth_id) where external_auth_id is not null;

-- One AI Agent service user per existing tenant. New tenants get theirs from createTenant().
insert into users (org_id, email, display_name, kind, timezone)
select o.id, 'ai-agent@' || o.slug || '.internal', 'AI Agent', 'service', o.timezone
  from organizations o
 where not exists (select 1 from users u where u.org_id = o.id and u.kind = 'service');
```

- [ ] **Step 4: Drizzle schema**

In `packages/db/src/schema.ts`, `organizations`: add after `dncMode`:
```ts
  /** URL-safe tenant identifier; unique across the platform. */
  slug: text('slug').notNull(),
  timezone: text('timezone').default('America/Los_Angeles').notNull(),
  /** Per-tenant toggles; later sub-projects add smsMode, dialRatio, botDisclosure. */
  settings: jsonb('settings').default(sql`'{}'::jsonb`).notNull(),
  /** 'active' | 'suspended' */
  status: text('status').default('active').notNull(),
  /** WorkOS organization id once the tenant is linked for product sign-in. */
  workosOrgId: text('workos_org_id'),
```
Convert the table to the two-argument form and add `(t) => ({ slugUnique: uniqueIndex('organizations_slug_unique').on(t.slug) })`.

`users`: add after `powerDialerEnabled`:
```ts
  /** 'human' signs in and works leads; 'service' is the tenant's AI Agent and can never hold a session. */
  kind: text('kind').$type<UserKind>().default('human').notNull(),
  /** WorkOS user id for product sign-in; null for Salesforce-only reps and service users. */
  externalAuthId: text('external_auth_id'),
  /** Platform staff: may switch tenants. */
  isSuperAdmin: boolean('is_super_admin').default(false).notNull(),
```
and replace the index block `emailIdx: uniqueIndex('users_email_unique').on(t.email),` with `orgEmailUnique: uniqueIndex('users_org_email_unique').on(t.orgId, t.email),`.

Add near the type helpers: `export type UserKind = 'human' | 'service';` (declare it above the `users` table so `$type<UserKind>()` resolves) and export it from `packages/db/src/index.ts`'s `export type { … }` list.

- [ ] **Step 5: Implement `tenancy.ts`**

`packages/auth/src/tenancy.ts`:
```ts
/**
 * Tenant provisioning shared by the Salesforce login path (cti-api) and the
 * product's provisionTenant (outreach-api, later plan): one org, its AI Agent
 * service user, and the default campaign, in a single transaction.
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema, type Db, type Organization } from '@cti/db';

export const AI_AGENT_DISPLAY_NAME = 'AI Agent';
const DEFAULT_TIMEZONE = 'America/Los_Angeles';

export function aiAgentEmail(slug: string): string {
  return `ai-agent@${slug}.internal`;
}

/** Lowercase; runs of non-alphanumerics become one '-'; leading/trailing dashes trimmed. */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export interface CreateTenantInput {
  name: string;
  slug?: string;
  timezone?: string;
  sfOrgId?: string | null;
}

export interface CreatedTenant {
  org: Organization;
  aiAgentUserId: string;
}

export async function createTenant(db: Db, input: CreateTenantInput): Promise<CreatedTenant> {
  const base = slugify(input.slug ?? input.name) || 'org';
  const timezone = input.timezone ?? DEFAULT_TIMEZONE;
  return db.transaction(async (tx) => {
    const taken = await tx.query.organizations.findFirst({
      where: eq(schema.organizations.slug, base),
      columns: { id: true },
    });
    const slug = taken ? `${base}-${randomBytes(3).toString('hex')}` : base;
    const [org] = await tx
      .insert(schema.organizations)
      .values({ name: input.name, slug, timezone, sfOrgId: input.sfOrgId ?? null })
      .returning();
    const [agent] = await tx
      .insert(schema.users)
      .values({ orgId: org!.id, email: aiAgentEmail(slug), displayName: AI_AGENT_DISPLAY_NAME, kind: 'service', timezone })
      .returning({ id: schema.users.id });
    await tx
      .insert(schema.campaignConfigs)
      .values({ orgId: org!.id, key: 'default', name: 'Default Campaign' })
      .onConflictDoNothing();
    return { org: org!, aiAgentUserId: agent!.id };
  });
}
```
Add `export * from './tenancy.js';` to `packages/auth/src/index.ts`.

- [ ] **Step 6: Run to verify pass**

```bash
cd /Users/cdrshepard/spam-res-cti && npm run build:packages && npm -w packages/auth run test 2>&1 | tail -5 && npm -w services/cti-api run typecheck
```
Expected: auth: 2 files, 15 tests pass; typecheck clean (cti-api does not yet insert organizations with a slug — Task 10 fixes the one call site; if typecheck fails on `routes/auth.ts` "Property 'slug' is missing", proceed to Task 10 before committing and fold that file into this commit).

- [ ] **Step 7: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti
git add packages/db packages/auth
git commit -m "feat(tenancy): organizations become tenants; users get kind/external auth/super admin; createTenant helper

Migration 0036 adds slug/timezone/settings/status/workos_org_id to
organizations (slugs backfilled from names, unique), kind/external_auth_id/
is_super_admin to users, moves email uniqueness to (org_id, email), and creates
one 'AI Agent' service user per existing org. @cti/auth gains slugify and
createTenant (org + AI Agent + default campaign in one transaction)."
```

---

### Task 9: Session hardening — service users never hold sessions (TDD)

**Files:**
- Create: `packages/auth/src/session.test.ts`
- Modify: `packages/auth/src/session.ts`

**Interfaces:**
- Produces: `resolveSession(bearer): Promise<SessionUser | null>` where `SessionUser = { userId: string; orgId: string; email: string; isAdmin: boolean; powerDialerEnabled: boolean; kind: UserKind; isSuperAdmin: boolean }`; returns `null` for a service user even with a valid token.
- Produces: `issueSession(userId, ttlDays?)` throws `ServiceUserSessionError` for a service user and `Error('Unknown user')` for a missing user; `class ServiceUserSessionError extends Error` (name `'ServiceUserSessionError'`).

- [ ] **Step 1: Write the failing tests**

`packages/auth/src/session.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  session: undefined as Record<string, unknown> | undefined,
  user: undefined as Record<string, unknown> | undefined,
  inserted: [] as Array<Record<string, unknown>>,
}));

vi.mock('@cti/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/db')>();
  const db = {
    query: {
      sessions: { findFirst: async () => state.session },
      users: { findFirst: async () => state.user },
    },
    insert: () => ({ values: async (v: Record<string, unknown>) => { state.inserted.push(v); } }),
  };
  return { ...actual, getDb: () => db };
});

import { sha256 } from './crypto.js';
import { issueSession, resolveSession, ServiceUserSessionError } from './session.js';

const human = { id: 'U1', orgId: 'O1', email: 'rep@example.com', isAdmin: false, powerDialerEnabled: true, kind: 'human', isSuperAdmin: false };
const service = { ...human, id: 'AI', email: 'ai-agent@gg-homes.internal', kind: 'service' };

beforeEach(() => {
  state.session = { userId: 'U1', tokenHash: 'h', expiresAt: new Date(Date.now() + 60_000), revokedAt: null };
  state.user = human;
  state.inserted = [];
});

describe('resolveSession', () => {
  it('returns the user with kind and isSuperAdmin', async () => {
    await expect(resolveSession('Bearer tok')).resolves.toEqual({
      userId: 'U1', orgId: 'O1', email: 'rep@example.com', isAdmin: false, powerDialerEnabled: true, kind: 'human', isSuperAdmin: false,
    });
  });
  it('returns null for a service user even with a valid session row', async () => {
    state.user = service;
    await expect(resolveSession('Bearer tok')).resolves.toBeNull();
  });
  it('returns null without a bearer or with an unknown token', async () => {
    await expect(resolveSession(undefined)).resolves.toBeNull();
    state.session = undefined;
    await expect(resolveSession('Bearer nope')).resolves.toBeNull();
  });
});

describe('issueSession', () => {
  it('stores only the sha256 of the token, with a 30-day expiry', async () => {
    const before = Date.now();
    const { token, expiresAt } = await issueSession('U1');
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({ userId: 'U1', tokenHash: sha256(token) });
    expect(expiresAt.getTime() - before).toBeGreaterThan(29 * 24 * 3600 * 1000);
  });
  it('refuses a service user and inserts nothing', async () => {
    state.user = service;
    await expect(issueSession('AI')).rejects.toBeInstanceOf(ServiceUserSessionError);
    expect(state.inserted).toHaveLength(0);
  });
  it('refuses an unknown user', async () => {
    state.user = undefined;
    await expect(issueSession('nope')).rejects.toThrow('Unknown user');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/cdrshepard/spam-res-cti && npm -w packages/auth run test 2>&1 | grep -E "session|✓|×|FAIL" | head -12
```
Expected: FAIL — `ServiceUserSessionError` is not exported; `kind`/`isSuperAdmin` missing from the resolved object.

- [ ] **Step 3: Implement**

Replace `packages/auth/src/session.ts` with:
```ts
/**
 * Opaque bearer sessions. The backend issues a random token, stores only its
 * sha256, and resolves it to the owning user. Any client (softphone, desktop,
 * iOS, product web app) exchanges its own sign-in for one of these, so every
 * service authorizes the same way.
 */
import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDb, schema, type UserKind } from '@cti/db';
import { randomToken, sha256 } from './crypto.js';

const DEFAULT_TTL_DAYS = 30;

export interface SessionUser {
  userId: string;
  orgId: string;
  email: string;
  isAdmin: boolean;
  powerDialerEnabled: boolean;
  kind: UserKind;
  isSuperAdmin: boolean;
}

/** A tenant's AI Agent (kind = 'service') acts through attribution, never through a session. */
export class ServiceUserSessionError extends Error {
  constructor(userId: string) {
    super(`Service user ${userId} cannot hold a session`);
    this.name = 'ServiceUserSessionError';
  }
}

export async function issueSession(userId: string, ttlDays = DEFAULT_TTL_DAYS): Promise<{ token: string; expiresAt: Date }> {
  const db = getDb();
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!user) throw new Error('Unknown user');
  if (user.kind === 'service') throw new ServiceUserSessionError(userId);
  const token = randomToken(32);
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 3600 * 1000);
  await db.insert(schema.sessions).values({ userId, tokenHash, expiresAt });
  return { token, expiresAt };
}

function bearerToken(bearer: string | undefined): string | null {
  if (!bearer) return null;
  const token = bearer.startsWith('Bearer ') ? bearer.slice(7) : bearer;
  return token || null;
}

export async function resolveSession(bearer: string | undefined): Promise<SessionUser | null> {
  const token = bearerToken(bearer);
  if (!token) return null;
  const db = getDb();
  const row = await db.query.sessions.findFirst({
    where: and(
      eq(schema.sessions.tokenHash, sha256(token)),
      gt(schema.sessions.expiresAt, new Date()),
      isNull(schema.sessions.revokedAt),
    ),
  });
  if (!row) return null;
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, row.userId) });
  if (!user || user.kind === 'service') return null;
  return {
    userId: user.id,
    orgId: user.orgId,
    email: user.email,
    isAdmin: user.isAdmin,
    powerDialerEnabled: user.powerDialerEnabled,
    kind: user.kind,
    isSuperAdmin: user.isSuperAdmin,
  };
}

export async function revokeSession(bearer: string): Promise<void> {
  const token = bearerToken(bearer);
  if (!token) return;
  await getDb()
    .update(schema.sessions)
    .set({ revokedAt: new Date() })
    .where(eq(schema.sessions.tokenHash, sha256(token)));
}
```

- [ ] **Step 4: Run to verify pass**

```bash
cd /Users/cdrshepard/spam-res-cti && npm run build:packages && npm -w packages/auth run test 2>&1 | tail -5 && npm -w services/cti-api run typecheck && npm -w services/cti-api run test 2>&1 | tail -4
```
Expected: auth: 3 files, 21 tests; typecheck clean; cti-api: 48 files, 653 tests (route tests mock `@cti/auth` wholesale, so the wider return type is invisible to them).

- [ ] **Step 5: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti
git add packages/auth
git commit -m "feat(auth): sessions carry kind and isSuperAdmin; service users can never hold one

resolveSession returns null for a kind='service' user even with a valid token,
and issueSession refuses to mint one (ServiceUserSessionError). First unit
tests for the session module."
```

---

### Task 10: `cti-api` adopts tenancy — org creation via `createTenant`, human-only user queries

**Files:**
- Create: `services/cti-api/src/tenancy/user-queries.ts`, `services/cti-api/src/tenancy/user-queries.test.ts`
- Modify: `services/cti-api/src/routes/auth.ts`, `services/cti-api/src/routes/admin.ts`

**Interfaces:**
- Produces: `humanUsersInOrg(orgId: string): SQL` and `humanUserByEmail(orgId: string, email: string): SQL` (Drizzle conditions) used as `where` clauses.
- Consumes: `createTenant` from `@cti/auth` (Task 8).

- [ ] **Step 1: Write the failing test** (renders the Drizzle condition to SQL the way `attempts.test.ts` does)

`services/cti-api/src/tenancy/user-queries.test.ts`:
```ts
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { humanUserByEmail, humanUsersInOrg } from './user-queries.js';

const dialect = new PgDialect();

describe('user-queries', () => {
  it('humanUsersInOrg scopes by org and excludes service users', () => {
    const q = dialect.sqlToQuery(humanUsersInOrg('O1'));
    expect(q.sql).toContain('"users"."org_id" = $1');
    expect(q.sql).toContain('"users"."kind" = $2');
    expect(q.params).toEqual(['O1', 'human']);
  });

  it('humanUserByEmail scopes by org and email and excludes service users', () => {
    const q = dialect.sqlToQuery(humanUserByEmail('O1', 'rep@example.com'));
    expect(q.params).toEqual(['O1', 'rep@example.com', 'human']);
    expect(q.sql).toContain('"users"."email" = $2');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/cdrshepard/spam-res-cti && npm -w services/cti-api run test -- src/tenancy 2>&1 | tail -5
```
Expected: FAIL — cannot resolve `./user-queries.js`.

- [ ] **Step 3: Implement the predicates**

`services/cti-api/src/tenancy/user-queries.ts`:
```ts
/**
 * The two ways cti-api looks up people, both tenant-scoped and both excluding
 * kind='service' (the AI Agent must never appear in rosters, assignment
 * dropdowns, or a login match).
 */
import { and, eq, type SQL } from 'drizzle-orm';
import { schema } from '@cti/db';

export function humanUsersInOrg(orgId: string): SQL {
  return and(eq(schema.users.orgId, orgId), eq(schema.users.kind, 'human'))!;
}

export function humanUserByEmail(orgId: string, email: string): SQL {
  return and(eq(schema.users.orgId, orgId), eq(schema.users.email, email), eq(schema.users.kind, 'human'))!;
}
```

- [ ] **Step 4: Use them**

`services/cti-api/src/routes/auth.ts`:
- Add imports: `import { createTenant, issueSession, resolveSession } from '@cti/auth';` (merge with the existing `@cti/auth` import) and `import { humanUserByEmail } from '../tenancy/user-queries.js';`.
- Replace the org-creation block (the `if (!org) { … }` that inserts `schema.organizations` and seeds the default campaign) with:
```ts
        if (!org) {
          // New tenant from a first Salesforce login: org + AI Agent service
          // user + default campaign, in one transaction (see @cti/auth createTenant).
          const created = await createTenant(db, { name: `Salesforce Org ${tok.sfOrgId}`, sfOrgId: tok.sfOrgId });
          org = created.org;
        }
```
- Replace `let user = await db.query.users.findFirst({ where: eq(schema.users.email, email) });` with `let user = await db.query.users.findFirst({ where: humanUserByEmail(org.id, email) });`.

`services/cti-api/src/routes/admin.ts`:
- Add `import { humanUsersInOrg } from '../tenancy/user-queries.js';`.
- In `GET /admin/reps` and `GET /admin/team`, replace `.where(eq(schema.users.orgId, s.orgId))` with `.where(humanUsersInOrg(s.orgId))`.

```bash
cd /Users/cdrshepard/spam-res-cti/services/cti-api && grep -n "humanUsersInOrg\|humanUserByEmail\|createTenant" src/routes/auth.ts src/routes/admin.ts
```
Expected: one `createTenant` call and one `humanUserByEmail` in auth.ts; two `humanUsersInOrg` in admin.ts.

- [ ] **Step 5: Verify**

```bash
cd /Users/cdrshepard/spam-res-cti && npm -w services/cti-api run typecheck && npm -w services/cti-api run test 2>&1 | tail -4
```
Expected: typecheck clean; cti-api: **49 files, 655 tests**.

- [ ] **Step 6: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti
git add services/cti-api
git commit -m "feat(cti-api): provision new Salesforce-login orgs via createTenant; rosters and login match exclude service users

A first login from a new Salesforce org now creates the tenant, its AI Agent,
and the default campaign in one transaction. User lookup on login is scoped to
the org (email is unique per tenant now). /admin/reps and /admin/team list
humans only."
```

---

### Task 11: Rollout runbook

**Files:**
- Create: `docs/runbooks/tenancy-migration.md`

- [ ] **Step 1: Write the runbook**

`docs/runbooks/tenancy-migration.md`:
```markdown
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
```

- [ ] **Step 2: Commit**

```bash
cd /Users/cdrshepard/spam-res-cti
git add docs/runbooks/tenancy-migration.md
git commit -m "docs(runbooks): two-step rollout for package extraction and tenancy, with verification SQL and rollback notes"
```

---

## Self-review against the spec

- **§3.1 packages**: db (T2/T3), phone (T1), auth incl. crypto (T4), firewall two-pass (T5/T6; spec wording corrected in T7). `contracts` deferred to the plan that gives it content (spec corrected in T7). `salesforce` extraction is spec'd for rollout step 6, not this plan.
- **§3.1 rules**: one package per commit ✓; tests green each commit ✓ (counts stated); migrations path + tracking table unchanged ✓; advisory lock ✓ (T3); Dockerfiles/railway.json ✓ (T2, T4, T5, verified T7).
- **§4.1 schema**: all organizations and users columns, per-tenant email uniqueness, `resolveSession` returning kind + isSuperAdmin, service users refused ✓ (T8, T9).
- **§4.2 AI Agent**: migration backfill + `createTenant` ✓.
- **§4.5 provisioning**: `createTenant` core ✓; WorkOS org creation, invite, and the `POST /admin/tenants` route belong to the outreach-api plan (they need `outreach-api`).
- **§13 steps 1–2** and the runbook ✓ (T11).
- Type consistency: `Db` from `@cti/db` used in `@cti/auth` and `@cti/firewall`; `UserKind` exported from `@cti/db` and used by `SessionUser`; `FirewallDeps`/`RecipientAddress`/`RecipientLookupUnauthorizedError` names match between T6's package and adapter; `createTenant` return `{ org, aiAgentUserId }` used identically in T8 test and T10 route.
